"""Create the first network and its admin from an existing Supabase auth user.

Operator tool, run once by the owner. The admin signs up first (the account is created in the
Supabase dashboard, Authentication -> Users); this script then looks that account up by email
and creates, in ONE transaction, the network, the admin's person and the active `admin` member
that ties the account to them. After that, the access token hook stamps `network_id`,
`member_role` and `person_id` into the admin's tokens, and the admin enrolls TOTP at first login
(admin endpoints require `aal2`).

It runs as the database owner, outside row-level security: there is no member yet for RLS to
admit. Point DATABASE_URL at the hosted session pooler (port 5432) with the owner's connection
string. The repo-root ``.env`` is loaded automatically (exported variables win); pass
``--env-file`` for another file.

Run from the repo root:

    uv run --project apps/api python apps/api/scripts/bootstrap_admin.py \\
        --email admin@example.com --name-ar "اسمك" [--name-latin "Your Name"] \\
        [--network-name "My Network"]

Idempotent: if the account is already a member, it prints "already bootstrapped" and exits 0.
Exits 1, with a message on stderr, when no auth user has that email.
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID

import psycopg
from dotenv import load_dotenv

from connections_api.db import connect

DEFAULT_ENV_FILE = Path(__file__).resolve().parents[3] / ".env"
DEFAULT_NETWORK_NAME = "My Network"


class UserNotFoundError(Exception):
    """No auth.users row has the given email."""


@dataclass(frozen=True)
class BootstrapResult:
    created: bool
    network_id: UUID
    person_id: UUID
    user_id: UUID


def bootstrap_admin(
    conn: psycopg.Connection[Any],
    *,
    email: str,
    name_ar: str,
    name_latin: str | None = None,
    network_name: str = DEFAULT_NETWORK_NAME,
) -> BootstrapResult:
    """Create the network, admin person and admin member for ``email``, once.

    ``conn`` must not be inside a transaction: this opens its own, so either everything is
    written or nothing is. Raises UserNotFoundError when no auth user has that email (nothing is
    written), and returns ``created=False`` with the existing ids when already bootstrapped.
    """
    with conn.transaction():
        users = conn.execute(
            "select id from auth.users where lower(email) = lower(%s)", (email.strip(),)
        ).fetchall()
        if not users:
            raise UserNotFoundError(
                f"No auth user with email {email}. Create the user in the Supabase dashboard "
                "(Authentication -> Users) first, then re-run."
            )
        if len(users) > 1:
            raise RuntimeError(
                f"{len(users)} auth users share the email {email}; refusing to guess."
            )
        user_id: UUID = users[0][0]

        existing = conn.execute(
            "select network_id, person_id from member where user_id = %s", (user_id,)
        ).fetchone()
        if existing is not None:
            return BootstrapResult(False, existing[0], existing[1], user_id)

        network_row = conn.execute(
            "insert into network (name) values (%s) returning id", (network_name,)
        ).fetchone()
        assert network_row is not None
        network_id: UUID = network_row[0]
        person_row = conn.execute(
            "insert into person (network_id, name_ar, name_latin) values (%s, %s, %s) returning id",
            (network_id, name_ar, name_latin),
        ).fetchone()
        assert person_row is not None
        person_id: UUID = person_row[0]
        conn.execute(
            "insert into member (network_id, user_id, person_id, role, status)"
            " values (%s, %s, %s, 'admin', 'active')",
            (network_id, user_id, person_id),
        )
    return BootstrapResult(True, network_id, person_id, user_id)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--email", required=True, help="Email of the existing Supabase auth user.")
    parser.add_argument("--name-ar", required=True, help="The admin's name in Arabic.")
    parser.add_argument("--name-latin", default=None, help="The admin's name in Latin script.")
    parser.add_argument("--network-name", default=DEFAULT_NETWORK_NAME)
    parser.add_argument(
        "--env-file",
        type=Path,
        default=DEFAULT_ENV_FILE,
        help="Path to the .env file to load (defaults to the repo-root .env).",
    )
    args = parser.parse_args(argv)
    if "@" not in args.email:
        parser.error("--email must be an email address")
    if not args.name_ar.strip():
        parser.error("--name-ar must not be blank")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.env_file.is_file():
        load_dotenv(dotenv_path=args.env_file, override=False)
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL is not set (export it or put it in .env).", file=sys.stderr)
        return 1

    try:
        with connect(dsn, autocommit=True) as conn:
            result = bootstrap_admin(
                conn,
                email=args.email,
                name_ar=args.name_ar,
                name_latin=args.name_latin,
                network_name=args.network_name,
            )
    except UserNotFoundError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    if result.created:
        print(
            f"Bootstrapped {args.email}: network {result.network_id}, person {result.person_id}."
            " Sign in and enroll TOTP; admin endpoints require it."
        )
    else:
        print(f"{args.email} is already bootstrapped (network {result.network_id}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())

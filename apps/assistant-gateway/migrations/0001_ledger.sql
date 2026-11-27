-- The spending ledger. One row per reservation; it is settled, released or expired later.
-- No prompt text, messages, model output or audio is ever stored here.
create table assistant_gateway.ledger_entry (
    id uuid primary key default gen_random_uuid(),
    app text not null,
    use_case text not null,
    end_user_id text not null,
    kind text not null check (kind in ('llm', 'speech')),
    -- the model id, or the speech provider name
    model text not null,
    status text not null check (status in ('reserved', 'settled', 'released', 'expired', 'unknown')),
    reserved_usd numeric(12, 6) not null,
    actual_usd numeric(12, 6),
    input_tokens int,
    output_tokens int,
    cache_read_tokens int,
    cache_write_tokens int,
    audio_seconds numeric(8, 2),
    error_code text,
    created_at timestamptz not null default now(),
    settled_at timestamptz
);

create index ledger_entry_app_created_at_idx
    on assistant_gateway.ledger_entry (app, created_at);

create index ledger_entry_app_reserved_idx
    on assistant_gateway.ledger_entry (app, status, created_at)
    where status = 'reserved';

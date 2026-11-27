import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  Injector,
  OnInit,
  inject,
  input,
  output,
  signal,
  viewChildren,
} from '@angular/core';
import {
  AbstractControl,
  FormBuilder,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatDialog } from '@angular/material/dialog';
import { MatInputModule } from '@angular/material/input';
import { MatRadioModule } from '@angular/material/radio';
import { TranslatePipe } from '@ngx-translate/core';
import type {
  AvailableFor,
  ContactKind,
  Seniority,
  SocialLinkKind,
  Strength,
  TagKind,
  TagOut,
} from '@connections/domain-types';
import { type Observable, debounceTime, map, tap } from 'rxjs';

import { ApiClient, toApiError } from '../../core/api.client';
import { IsolatePipe } from '../../core/bidi';
import { isContactPickerSupported, pickContact } from '../../core/contact-picker';
import { DraftStore } from '../../core/draft.store';
import { IDEMPOTENCY_KEY_PATTERN, newIdempotencyKey } from '../../core/idempotency';
import { ConfirmDialog, type ConfirmDialogData } from '../../layout/confirm.dialog';
import { type PersonErrorMessage, personErrorMessage } from './person-errors';
import {
  AVAILABLE_FOR_OPTIONS,
  CONTACT_KIND_OPTIONS,
  type ConnectTarget,
  type PersonFormValue,
  SENIORITY_OPTIONS,
  SOCIAL_KIND_OPTIONS,
  STRENGTH_OPTIONS,
  type TagSuggest,
  type TagSuggestion,
  type TagValue,
  emptyPersonFormValue,
  hasName,
  hasOptionalValues,
  parseFormValue,
} from './person-form.model';
import { PersonPickerComponent } from './person-picker.component';
import { TagInputComponent } from './tag-input.component';

const ARABIC_SCRIPT = /[؀-ۿ]/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How long typing pauses before the entry is kept as a draft (not on every keystroke). */
const TYPING_DRAFT_DELAY_MS = 800;

/** What a draft stores besides the form value. */
interface DraftMeta {
  /**
   * The Idempotency-Key of the submission that failed, so its retry is the same submission. A
   * create's draft with a key is that exact submission: it is restored locked. A draft kept while
   * typing (nothing sent yet) has none and is restored editable.
   */
  idempotencyKey?: string;
  /** Whose draft it is (the contributor link's token digest), when the form is given a `draftOwner`. */
  draftOwner?: string;
  savedAt?: string;
}

const nameRequired = (group: AbstractControl): ValidationErrors | null =>
  hasName({ nameAr: group.get('nameAr')?.value ?? '', nameLatin: group.get('nameLatin')?.value ?? '' })
    ? null
    : { nameRequired: true };

/**
 * The person form shared by "Add person" and "Edit person".
 *
 * Required: a name (Arabic or Latin) and, when adding, a connection strength. Everything else sits
 * under "More details". The form sends nothing itself: it hands its value to `submitter` and
 * reports what that returns through `saved`.
 *
 * Drafts (online-only app): nothing is stored while typing. When `submitter` fails with a network
 * or server error, or because the session ended (401, `mfa_required`), the value is kept on this
 * device under `draftKey` and a retry is offered; a draft found on open is restored; a successful
 * save clears it. A draft given a `draftOwner` is restored only for that owner, and one older than
 * `draftMaxAgeDays` is dropped.
 *
 * Every submission carries an Idempotency-Key (the submitter's second argument): the same key on
 * a retry, and in the draft, so resubmitting after a lost answer never creates the person twice.
 *
 * A create that failed that way may still have been saved (only its answer was lost), and the
 * server answers a reused key with the person it created, never with edits made since. So the form
 * is then locked: every field is read-only, Retry resends exactly the payload that failed with its
 * key, and "Start over" (after a confirmation) drops the draft and the key and makes the same
 * values editable again under a new key. A create's draft that carries a key is restored locked.
 * An edit (a PUT, which needs no key) is never locked.
 *
 * Text typed into a skill or industry field but not added yet is added on save when it needs
 * nothing more; a skill still missing its category stops the save and says so.
 */
@Component({
  selector: 'app-person-form',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatRadioModule,
    TranslatePipe,
    TagInputComponent,
    PersonPickerComponent,
    IsolatePipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
      @if (draftRestored()) {
        <div class="draft-note" role="status">
          <span>{{ 'person.form.draftRestored' | translate }}</span>
          @if (!locked()) {
            <button mat-button type="button" class="discard" (click)="discardDraft()">
              {{ 'person.form.discardDraft' | translate }}
            </button>
          }
        </div>
      }

      @if (pickerSupported) {
        <button
          mat-stroked-button
          type="button"
          class="pick-contact"
          [disabled]="locked()"
          (click)="pickFromContacts()"
        >
          <mat-icon aria-hidden="true">contacts</mat-icon>
          {{ 'person.form.pickFromContacts' | translate }}
        </button>
      }

      <section class="names">
        <mat-form-field appearance="outline" subscriptSizing="dynamic">
          <mat-label>{{ 'person.form.nameAr' | translate }}</mat-label>
          <input matInput dir="rtl" formControlName="nameAr" autocomplete="off" />
        </mat-form-field>
        <mat-form-field appearance="outline" subscriptSizing="dynamic">
          <mat-label>{{ 'person.form.nameLatin' | translate }}</mat-label>
          <input matInput dir="ltr" formControlName="nameLatin" autocomplete="off" />
        </mat-form-field>
        @if (submitAttempted() && form.hasError('nameRequired')) {
          <p class="field-error" role="alert">{{ 'person.errors.nameRequired' | translate }}</p>
        } @else {
          <p class="hint">{{ 'person.form.nameHint' | translate }}</p>
        }
      </section>

      <!-- The number is what most people know about someone they just met: not under More details. -->
      <fieldset class="rows contacts" formArrayName="contacts">
        <legend>{{ 'person.form.contacts' | translate }}</legend>
        @for (row of contacts.controls; track row; let i = $index) {
          <div class="row" [formGroupName]="i">
            <mat-form-field appearance="outline" subscriptSizing="dynamic" class="kind">
              <mat-label>{{ 'person.form.kind' | translate }}</mat-label>
              <select matNativeControl formControlName="kind">
                @for (option of contactKinds; track option.value) {
                  <option [value]="option.value">{{ option.labelKey | translate }}</option>
                }
              </select>
            </mat-form-field>
            <mat-form-field appearance="outline" subscriptSizing="dynamic" class="grow">
              <mat-label>{{ 'person.form.contactValue' | translate }}</mat-label>
              <input matInput dir="ltr" formControlName="value" autocomplete="off" class="contact-value" />
            </mat-form-field>
            <button
              mat-icon-button
              type="button"
              [attr.aria-label]="'person.form.removeRow' | translate"
              [disabled]="locked()"
              (click)="contacts.removeAt(i)"
            >
              <mat-icon aria-hidden="true">delete</mat-icon>
            </button>
          </div>
        }
        <button mat-stroked-button type="button" class="add-row" [disabled]="locked()" (click)="addContact()">
          {{ 'person.form.addContact' | translate }}
        </button>
      </fieldset>

      @if (mode() === 'add') {
        <fieldset class="strength">
          <legend>
            {{ (contributor() ? 'contribute.strengthLabel' : 'person.strength.label') | translate }}
          </legend>
          <mat-radio-group formControlName="strength" class="strength-options">
            @for (option of strengths; track option.value) {
              <mat-radio-button [value]="option.value" [attr.value]="option.value">
                {{ option.labelKey | translate }}
              </mat-radio-button>
            }
          </mat-radio-group>
          <p class="strength-help hint">{{ 'person.strength.help' | translate }}</p>
          @if (submitAttempted() && form.controls.strength.invalid) {
            <p class="field-error" role="alert">{{ 'person.errors.strengthRequired' | translate }}</p>
          }
        </fieldset>

        @if (!contributor()) {
          <app-person-picker
            [value]="form.controls.connectTo.value"
            [disabled]="locked()"
            (valueChange)="form.controls.connectTo.setValue($event)"
          />
        }
      }

      <details class="more" [open]="moreOpen()" (toggle)="onToggle($event)">
        <summary>{{ 'person.form.moreDetails' | translate }}</summary>

        <div class="more-fields">
          @if (mode() === 'add' && !contributor()) {
            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <mat-label>{{ 'person.form.connectionNote' | translate }}</mat-label>
              <input matInput formControlName="connectionNote" autocomplete="off" />
            </mat-form-field>
          }

          <mat-form-field appearance="outline" subscriptSizing="dynamic">
            <mat-label>{{ 'person.form.headline' | translate }}</mat-label>
            <input matInput formControlName="headline" autocomplete="off" />
          </mat-form-field>
          <mat-form-field appearance="outline" subscriptSizing="dynamic">
            <mat-label>{{ 'person.form.organization' | translate }}</mat-label>
            <input matInput formControlName="organization" autocomplete="off" />
          </mat-form-field>
          <mat-form-field appearance="outline" subscriptSizing="dynamic">
            <mat-label>{{ 'person.form.profession' | translate }}</mat-label>
            <input matInput formControlName="profession" autocomplete="off" />
          </mat-form-field>

          <mat-form-field appearance="outline" subscriptSizing="dynamic">
            <mat-label>{{ 'person.form.seniority' | translate }}</mat-label>
            <select matNativeControl formControlName="seniority">
              <option [ngValue]="null">{{ 'person.form.seniorityNone' | translate }}</option>
              @for (option of seniorities; track option.value) {
                <option [ngValue]="option.value">{{ option.labelKey | translate }}</option>
              }
            </select>
          </mat-form-field>

          <fieldset class="available">
            <legend>{{ 'person.form.availableFor' | translate }}</legend>
            @for (option of availableFor; track option.value) {
              <mat-checkbox
                [checked]="form.controls.availableFor.value.includes(option.value)"
                [disabled]="locked()"
                (change)="toggleAvailableFor(option.value, $event.checked)"
              >
                {{ option.labelKey | translate }}
              </mat-checkbox>
            }
          </fieldset>

          <mat-form-field appearance="outline" subscriptSizing="dynamic">
            <mat-label>{{ 'person.form.city' | translate }}</mat-label>
            <input matInput formControlName="city" autocomplete="off" />
          </mat-form-field>
          <mat-form-field appearance="outline" subscriptSizing="dynamic">
            <mat-label>{{ 'person.form.country' | translate }}</mat-label>
            <input matInput formControlName="country" autocomplete="off" />
          </mat-form-field>

          <app-tag-input
            kind="skill"
            labelKey="person.form.skills"
            [suggest]="suggest"
            [disabled]="locked()"
            [value]="form.controls.skills.value"
            (valueChange)="form.controls.skills.setValue($event)"
          />
          <app-tag-input
            kind="industry"
            labelKey="person.form.industries"
            [suggest]="suggest"
            [disabled]="locked()"
            [value]="form.controls.industries.value"
            (valueChange)="form.controls.industries.setValue($event)"
          />

          <fieldset class="rows social-links" formArrayName="socialLinks">
            <legend>{{ 'person.form.socialLinks' | translate }}</legend>
            @for (row of socialLinks.controls; track row; let i = $index) {
              <div class="row" [formGroupName]="i">
                <mat-form-field appearance="outline" subscriptSizing="dynamic" class="kind">
                  <mat-label>{{ 'person.form.kind' | translate }}</mat-label>
                  <select matNativeControl formControlName="kind">
                    @for (option of socialKinds; track option.value) {
                      <option [value]="option.value">{{ option.labelKey | translate }}</option>
                    }
                  </select>
                </mat-form-field>
                <mat-form-field appearance="outline" subscriptSizing="dynamic" class="grow">
                  <mat-label>{{ 'person.form.socialUrl' | translate }}</mat-label>
                  <input matInput type="url" dir="ltr" formControlName="url" autocomplete="off" class="social-url" />
                </mat-form-field>
                <button
                  mat-icon-button
                  type="button"
                  [attr.aria-label]="'person.form.removeRow' | translate"
                  [disabled]="locked()"
                  (click)="socialLinks.removeAt(i)"
                >
                  <mat-icon aria-hidden="true">delete</mat-icon>
                </button>
              </div>
            }
            <button mat-stroked-button type="button" class="add-row" [disabled]="locked()" (click)="addSocialLink()">
              {{ 'person.form.addSocialLink' | translate }}
            </button>
          </fieldset>


          @if (!contributor()) {
            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <mat-label>{{ 'person.form.adminNotes' | translate }}</mat-label>
              <textarea matInput rows="3" formControlName="adminNotes"></textarea>
              <mat-hint>{{ 'person.form.adminNotesHint' | translate }}</mat-hint>
            </mat-form-field>
          }
        </div>
      </details>

      @if (pendingTag(); as label) {
        <p class="pending-tag field-error" role="alert">
          {{ 'person.tags.pendingNotAdded' | translate: { label: (label | isolate) } }}
        </p>
      }

      @if (error(); as failure) {
        <div class="error" role="alert">
          <p>{{ failure.key | translate: { field: failure.fieldKey ? (failure.fieldKey | translate) : '' } }}</p>
          @if (failure.retryable && !locked()) {
            <button mat-stroked-button type="button" class="retry" [disabled]="busy()" (click)="retry()">
              {{ 'common.retry' | translate }}
            </button>
          }
        </div>
      }

      @if (locked()) {
        <div class="locked-note" role="status">
          <p>{{ 'person.form.locked' | translate }}</p>
          <div class="locked-actions">
            <button mat-stroked-button type="button" class="retry" [disabled]="busy()" (click)="retry()">
              {{ 'common.retry' | translate }}
            </button>
            <button mat-button type="button" class="start-over" [disabled]="busy()" (click)="startOver()">
              {{ 'person.form.startOver' | translate }}
            </button>
          </div>
        </div>
      }

      <button mat-flat-button type="submit" class="save" [disabled]="busy() || done() || locked()">
        {{ (busy() ? 'person.form.saving' : 'person.form.save') | translate }}
      </button>
    </form>
  `,
  styles: `
    form {
      display: flex;
      flex-direction: column;
      gap: 16px;
      max-inline-size: 640px;
    }
    mat-form-field {
      inline-size: 100%;
    }
    fieldset {
      margin: 0;
      padding: 0;
      border: 0;
      min-inline-size: 0;
    }
    legend {
      padding: 0;
      font: var(--mat-sys-title-small);
    }
    .names {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .hint {
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }
    .field-error,
    .error {
      color: var(--mat-sys-error);
    }
    .field-error {
      margin: 0;
    }
    .strength-options {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 16px;
    }
    .draft-note {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding-block: 8px;
      padding-inline: 12px;
      border-radius: 8px;
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }
    .locked-note {
      padding-block: 8px;
      padding-inline: 12px;
      border-radius: 8px;
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }
    .locked-note p {
      margin-block: 0 8px;
    }
    .locked-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .more {
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 12px;
      padding-inline: 12px;
    }
    .more summary {
      padding-block: 14px;
      font: var(--mat-sys-title-small);
      cursor: pointer;
    }
    .more-fields {
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding-block-end: 16px;
    }
    .available {
      display: flex;
      flex-direction: column;
    }
    .rows .row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin-block-start: 8px;
    }
    .rows .kind {
      flex: 0 0 9rem;
    }
    .rows .grow {
      flex: 1 1 12rem;
    }
    .add-row {
      margin-block-start: 8px;
    }
    .error p {
      margin-block: 0 8px;
    }
    .save {
      align-self: stretch;
      min-block-size: 48px;
    }
    @media (min-width: 720px) {
      .save {
        align-self: flex-start;
        min-inline-size: 12rem;
      }
    }
  `,
})
export class PersonFormComponent implements OnInit {
  readonly mode = input<'add' | 'edit'>('add');
  /** Where a failed save keeps its draft: "add-person" or "edit-person:<id>". */
  readonly draftKey = input.required<string>();
  /** Starting values for an edit; anything left out starts empty. */
  readonly initial = input<Partial<PersonFormValue> | null>(null);
  /**
   * Saves the value (the API call); its result is passed on through `saved`. The second argument
   * is the submission's Idempotency-Key, for a create (an edit may ignore it); the third is true
   * when this resends a submission that may already have reached the server (Retry, or one
   * restored after a reload), so the page can skip anything it does only before a first attempt.
   */
  readonly submitter =
    input.required<(value: PersonFormValue, idempotencyKey: string, retry: boolean) => Observable<unknown>>();
  readonly saved = output<unknown>();
  /**
   * A contributor adding people from their link (Task 16), not the admin: no private notes, no
   * connection note and no "Connected to" picker (the connection is always to the contributor).
   * The strength is still required.
   */
  readonly contributor = input(false);
  /** Where tag suggestions come from; the admin's `/tags` when not given. */
  readonly suggestSource = input<TagSuggest | null>(null);
  /** Whose draft this is (the contributor link's token digest): another owner's draft is dropped, not shown. */
  readonly draftOwner = input<string | null>(null);
  /** A draft older than this is dropped on open; drafts do not expire when not given. */
  readonly draftMaxAgeDays = input<number | null>(null);

  private readonly fb = inject(FormBuilder).nonNullable;
  // Looked up on first use: a contributor's form never needs the admin client (or its session).
  private readonly injector = inject(Injector);
  private readonly drafts = inject(DraftStore);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialog = inject(MatDialog);
  private readonly tagInputs = viewChildren(TagInputComponent);
  /** This submission's Idempotency-Key, from the first attempt until it succeeds. */
  private idempotencyKey: string | null = null;
  /** The create that failed, exactly as it was sent: what Retry resends while `locked`. */
  private failedCreate: { value: PersonFormValue; idempotencyKey: string } | null = null;
  /** The drafts' generation when the form opened: an explicit sign-out since then bumps it. */
  private readonly openedGeneration = this.drafts.generation;
  /** An edit not yet kept as a draft (the pause has not passed). */
  private typedPending = false;

  protected readonly strengths = STRENGTH_OPTIONS;
  protected readonly seniorities = SENIORITY_OPTIONS;
  protected readonly availableFor = AVAILABLE_FOR_OPTIONS;
  protected readonly socialKinds = SOCIAL_KIND_OPTIONS;
  protected readonly contactKinds = CONTACT_KIND_OPTIONS;
  protected readonly pickerSupported = isContactPickerSupported();

  protected readonly form = this.fb.group(
    {
      nameAr: [''],
      nameLatin: [''],
      strength: this.fb.control<Strength | null>(null),
      connectTo: this.fb.control<ConnectTarget | null>(null),
      connectionNote: [''],
      headline: [''],
      organization: [''],
      profession: [''],
      seniority: this.fb.control<Seniority | null>(null),
      availableFor: this.fb.control<AvailableFor[]>([]),
      city: [''],
      country: [''],
      adminNotes: [''],
      skills: this.fb.control<TagValue[]>([]),
      industries: this.fb.control<TagValue[]>([]),
      socialLinks: this.fb.array<FormGroup<{ kind: FormControl<SocialLinkKind>; url: FormControl<string> }>>([]),
      contacts: this.fb.array<FormGroup<{ kind: FormControl<ContactKind>; value: FormControl<string> }>>([]),
    },
    { validators: nameRequired },
  );

  protected readonly busy = signal(false);
  protected readonly submitAttempted = signal(false);
  protected readonly error = signal<PersonErrorMessage | null>(null);
  protected readonly draftRestored = signal(false);
  protected readonly moreOpen = signal(false);
  /** Saved: Save stays disabled until the page moves on, so a second press adds nobody twice. */
  protected readonly done = signal(false);
  /** Text in a tag field that could not be added on save. */
  protected readonly pendingTag = signal<string | null>(null);
  /** A create that may have been saved already: read-only until Retry succeeds or Start over. */
  protected readonly locked = signal(false);

  protected get socialLinks() {
    return this.form.controls.socialLinks;
  }

  protected get contacts() {
    return this.form.controls.contacts;
  }

  /** Autocomplete for skills and industries: `suggestSource`, else the admin's `/tags`. */
  protected readonly suggest = (kind: TagKind, q: string): Observable<TagSuggestion[]> => {
    const source = this.suggestSource();
    if (source) return source(kind, q);
    return this.injector
      .get(ApiClient)
      .get<TagOut[]>('/tags', { kind, q })
      .pipe(map((tags) => tags.map((t) => ({ label: t.label, category: t.category }))));
  };

  ngOnInit(): void {
    if (this.mode() === 'add') {
      this.form.controls.strength.addValidators(Validators.required);
      this.form.controls.strength.updateValueAndValidity();
    }
    const draft = this.loadDraft();
    if (draft) {
      this.apply(draft.value);
      this.draftRestored.set(true);
      if (this.mode() === 'add' && draft.idempotencyKey) this.lock(draft.value, draft.idempotencyKey);
    } else {
      this.apply(this.startingValue());
    }
    this.moreOpen.set(hasOptionalValues(this.currentValue()));
    // Leaving the page or reloading mid-entry (a call, a switch to copy a number) must not lose it:
    // kept after a pause, and at once when the form goes away or the page unloads.
    this.form.valueChanges
      .pipe(
        tap(() => (this.typedPending = true)),
        debounceTime(TYPING_DRAFT_DELAY_MS),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.keepTypedDraft());
    const flush = () => {
      if (this.typedPending) this.keepTypedDraft();
    };
    window.addEventListener('pagehide', flush);
    this.destroyRef.onDestroy(() => {
      window.removeEventListener('pagehide', flush);
      flush();
    });
  }

  protected onToggle(event: Event): void {
    this.moreOpen.set((event.target as HTMLDetailsElement).open);
  }

  protected toggleAvailableFor(option: AvailableFor, checked: boolean): void {
    if (this.locked()) return;
    const control = this.form.controls.availableFor;
    const rest = control.value.filter((v) => v !== option);
    control.setValue(checked ? [...rest, option] : rest);
  }

  protected addSocialLink(kind: SocialLinkKind = 'facebook', url = ''): void {
    if (this.locked()) return;
    this.socialLinks.push(this.fb.group({ kind: this.fb.control(kind), url: this.fb.control(url) }));
  }

  protected addContact(kind: ContactKind = 'phone', value = ''): void {
    if (this.locked()) return;
    this.contacts.push(this.fb.group({ kind: this.fb.control(kind), value: this.fb.control(value) }));
  }

  protected async pickFromContacts(): Promise<void> {
    if (this.locked()) return;
    const picked = await pickContact();
    if (!picked || this.locked()) return;
    const { nameAr, nameLatin } = this.form.controls;
    if (picked.name && !hasName({ nameAr: nameAr.value, nameLatin: nameLatin.value })) {
      (ARABIC_SCRIPT.test(picked.name) ? nameAr : nameLatin).setValue(picked.name);
    }
    if (picked.tel) this.addContactOnce('phone', picked.tel);
    if (picked.email) this.addContactOnce('email', picked.email);
    this.moreOpen.set(true);
    this.cdr.markForCheck();
  }

  protected discardDraft(): void {
    this.drafts.clear(this.draftKey());
    this.idempotencyKey = null;
    this.apply(this.startingValue());
    this.draftRestored.set(false);
    this.error.set(null);
    this.moreOpen.set(hasOptionalValues(this.currentValue()));
  }

  protected submit(): void {
    if (this.busy() || this.done()) return;
    // Save is disabled while locked; a submit that still arrives (Enter) is the retry.
    if (this.locked()) {
      this.retry();
      return;
    }
    this.submitAttempted.set(true);
    if (!this.commitPendingTags()) return;
    if (this.form.invalid) return;
    this.idempotencyKey ??= newIdempotencyKey();
    this.send(this.currentValue(), this.idempotencyKey, false);
  }

  /**
   * A locked create: resend the payload that failed, with its key, exactly as it was (the fields
   * are read-only, so there is nothing new to check or add). An edit: save the form again.
   */
  protected retry(): void {
    const failed = this.failedCreate;
    if (!failed) {
      this.submit();
      return;
    }
    if (this.busy() || this.done()) return;
    this.send(failed.value, failed.idempotencyKey, true);
  }

  /**
   * After a confirmation: forget the locked submission (its draft and key) and make the same values
   * editable again; the next save is a new submission with a new key. If the first attempt did
   * reach the server, that save adds the person a second time, which the dialog says.
   */
  protected startOver(): void {
    const data: ConfirmDialogData = {
      titleKey: 'person.form.startOverDialog.title',
      bodyKey: 'person.form.startOverDialog.body',
      confirmKey: 'person.form.startOverDialog.confirm',
    };
    this.dialog
      .open(ConfirmDialog, { data })
      .afterClosed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((confirmed: boolean | undefined) => {
        const failed = this.failedCreate;
        if (confirmed !== true || !failed || this.busy()) return;
        this.drafts.clear(this.draftKey());
        this.idempotencyKey = null;
        // Unlock first: apply() rebuilds the contact and social-link rows, and the add-row
        // helpers refuse to add rows to a locked form.
        this.unlock();
        this.apply(failed.value);
        this.draftRestored.set(false);
        this.error.set(null);
        this.cdr.markForCheck();
      });
  }

  /** Adds typed-but-not-added tags; false (and the message) when one cannot be added. */
  private commitPendingTags(): boolean {
    const blocked = this.tagInputs()
      .map((input) => input.commitPending())
      .find((label) => label !== null);
    this.pendingTag.set(blocked ?? null);
    if (blocked) this.moreOpen.set(true);
    return !blocked;
  }

  private send(value: PersonFormValue, key: string, retry: boolean): void {
    const generation = this.drafts.generation;
    this.busy.set(true);
    this.error.set(null);
    // Kept before it leaves: if the page reloads while it is in flight, a create comes back as that
    // same submission (locked, retried with its key), an edit as what was being saved.
    this.typedPending = false;
    if (generation === this.openedGeneration) this.saveDraft(value, key);
    // Cancelled with the form: a save still pending when the page goes away must not write a
    // draft or emit afterwards.
    this.submitter()(value, key, retry)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result) => {
          this.busy.set(false);
          this.done.set(true);
          this.idempotencyKey = null;
          this.unlock();
          this.drafts.clear(this.draftKey());
          this.saved.emit(result);
        },
        error: (failure: unknown) => this.onFailure(failure, value, key, generation),
      });
  }

  /** Read-only, with `value` and its key kept for Retry. */
  private lock(value: PersonFormValue, idempotencyKey: string): void {
    this.failedCreate = { value, idempotencyKey };
    this.locked.set(true);
    this.form.disable({ emitEvent: false });
  }

  private unlock(): void {
    this.failedCreate = null;
    this.locked.set(false);
    this.form.enable({ emitEvent: false });
  }

  private onFailure(
    failure: unknown,
    value: PersonFormValue,
    idempotencyKey: string,
    generation: number,
  ): void {
    const apiError = toApiError(failure);
    this.busy.set(false);
    // Keep the entry for a network or server failure (nothing about the data was refused), and
    // when the session ended or its MFA step lapsed: ApiClient sends the admin to /login or /mfa,
    // and they must find their input on return. Any other rejection (a 4xx about the data) never
    // saves a draft. The message is shown either way (it says why, until the page moves on).
    const sessionEnded = apiError.code === 'mfa_required' || apiError.status === 401;
    const message = personErrorMessage(apiError);
    // An explicit sign-out while this save was pending cleared every draft (the next person at
    // this browser must not find this one); a session that merely ended keeps them.
    const clearedSince = this.drafts.generation !== generation;
    const maybeSaved = message.retryable || sessionEnded;
    if (maybeSaved && !clearedSince) this.saveDraft(value, idempotencyKey);
    // Refused, so nothing was created: the submission kept before sending becomes what was typed,
    // editable, under no key. A draft the page removed meanwhile (a dead link) stays removed.
    const keptBeforeSending = this.drafts.load<unknown>(this.draftKey()) !== null;
    if (!maybeSaved && !clearedSince && !this.locked() && keptBeforeSending) this.saveDraft(value, null);
    // A create that may have gone through is locked to what was sent (once locked, it stays so
    // until it succeeds or the user starts over, whatever a later attempt answers).
    if (maybeSaved && this.mode() === 'add' && !this.locked()) this.lock(value, idempotencyKey);
    this.error.set(message);
    this.cdr.markForCheck();
  }

  /**
   * The entry as typed, kept under no key (restored editable). Not while a save is in flight, done
   * or locked: those keep the draft of the submission itself. Typing back to the starting values
   * leaves nothing to keep.
   */
  private keepTypedDraft(): void {
    this.typedPending = false;
    const signedOutSince = this.drafts.generation !== this.openedGeneration;
    if (signedOutSince || this.busy() || this.done() || this.locked()) return;
    const value = this.currentValue();
    if (JSON.stringify(value) === JSON.stringify(this.startingValue())) {
      this.drafts.clear(this.draftKey());
      return;
    }
    this.saveDraft(value, null);
  }

  private saveDraft(value: PersonFormValue, idempotencyKey: string | null): void {
    const meta: DraftMeta = { savedAt: new Date().toISOString() };
    if (idempotencyKey !== null) meta.idempotencyKey = idempotencyKey;
    const owner = this.draftOwner();
    if (owner !== null) meta.draftOwner = owner;
    this.drafts.save(this.draftKey(), { ...value, ...meta });
  }

  /**
   * The stored draft and the key it was sent with, when there is one for this owner and it is not
   * too old; else null.
   */
  private loadDraft(): { value: PersonFormValue; idempotencyKey: string | null } | null {
    const raw = this.drafts.load<unknown>(this.draftKey());
    const value = parseFormValue(raw);
    if (!value) return null;
    const meta = raw as DraftMeta;
    const owner = this.draftOwner();
    const maxAgeDays = this.draftMaxAgeDays();
    const savedAt = typeof meta.savedAt === 'string' ? Date.parse(meta.savedAt) : NaN;
    const wrongOwner = owner !== null && meta.draftOwner !== owner;
    const tooOld = maxAgeDays !== null && !(Date.now() - savedAt <= maxAgeDays * DAY_MS);
    if (wrongOwner || tooOld) {
      this.drafts.clear(this.draftKey());
      return null;
    }
    const key = meta.idempotencyKey;
    this.idempotencyKey = typeof key === 'string' && IDEMPOTENCY_KEY_PATTERN.test(key) ? key : null;
    return { value, idempotencyKey: this.idempotencyKey };
  }

  private addContactOnce(kind: ContactKind, value: string): void {
    const exists = this.contacts.controls.some(
      (row) => row.controls.kind.value === kind && row.controls.value.value.trim() === value,
    );
    if (exists) return;
    const empty = this.contacts.controls.find((row) => row.controls.value.value.trim() === '');
    if (empty) empty.setValue({ kind, value });
    else this.addContact(kind, value);
  }

  /** An add starts with one empty WhatsApp row (dropped on save when left blank). */
  private startingValue(): PersonFormValue {
    const value = { ...emptyPersonFormValue(), ...(this.initial() ?? {}) };
    if (this.mode() === 'add' && value.contacts.length === 0) value.contacts = [{ kind: 'whatsapp', value: '' }];
    return value;
  }

  /** The form as plain data: what a draft stores and what `submitter` receives. */
  private currentValue(): PersonFormValue {
    const raw = this.form.getRawValue();
    return {
      ...raw,
      skills: raw.skills.flatMap((t) =>
        t.category ? [{ label: t.label, category: t.category, level: t.level }] : [],
      ),
      industries: raw.industries.map((t) => t.label),
    };
  }

  private apply(value: PersonFormValue): void {
    this.form.patchValue({
      nameAr: value.nameAr,
      nameLatin: value.nameLatin,
      strength: value.strength,
      connectTo: value.connectTo,
      connectionNote: value.connectionNote,
      headline: value.headline,
      organization: value.organization,
      profession: value.profession,
      seniority: value.seniority,
      availableFor: value.availableFor,
      city: value.city,
      country: value.country,
      adminNotes: value.adminNotes,
      skills: value.skills.map((s) => ({ label: s.label, category: s.category, level: s.level ?? null })),
      industries: value.industries.map((label) => ({ label, category: null, level: null })),
    });
    this.socialLinks.clear();
    value.socialLinks.forEach((l) => this.addSocialLink(l.kind, l.url));
    this.contacts.clear();
    value.contacts.forEach((c) => this.addContact(c.kind, c.value));
  }
}

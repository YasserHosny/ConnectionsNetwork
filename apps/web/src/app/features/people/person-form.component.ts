import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  Injector,
  OnInit,
  inject,
  input,
  output,
  signal,
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
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatRadioModule } from '@angular/material/radio';
import { Router } from '@angular/router';
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
import { type Observable, map } from 'rxjs';

import { ApiClient, toApiError } from '../../core/api.client';
import { isContactPickerSupported, pickContact } from '../../core/contact-picker';
import { DraftStore } from '../../core/draft.store';
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
 * or server error the value is kept on this device under `draftKey` and a retry is offered; a
 * draft found on open is restored; a successful save clears it.
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
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
      @if (draftRestored()) {
        <div class="draft-note" role="status">
          <span>{{ 'person.form.draftRestored' | translate }}</span>
          <button mat-button type="button" class="discard" (click)="discardDraft()">
            {{ 'person.form.discardDraft' | translate }}
          </button>
        </div>
      }

      @if (pickerSupported) {
        <button mat-stroked-button type="button" class="pick-contact" (click)="pickFromContacts()">
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
            [value]="form.controls.skills.value"
            (valueChange)="form.controls.skills.setValue($event)"
          />
          <app-tag-input
            kind="industry"
            labelKey="person.form.industries"
            [suggest]="suggest"
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
                  (click)="socialLinks.removeAt(i)"
                >
                  <mat-icon aria-hidden="true">delete</mat-icon>
                </button>
              </div>
            }
            <button mat-stroked-button type="button" class="add-row" (click)="addSocialLink()">
              {{ 'person.form.addSocialLink' | translate }}
            </button>
          </fieldset>

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
                  (click)="contacts.removeAt(i)"
                >
                  <mat-icon aria-hidden="true">delete</mat-icon>
                </button>
              </div>
            }
            <button mat-stroked-button type="button" class="add-row" (click)="addContact()">
              {{ 'person.form.addContact' | translate }}
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

      @if (error(); as failure) {
        <div class="error" role="alert">
          <p>{{ failure.key | translate: { field: failure.fieldKey ? (failure.fieldKey | translate) : '' } }}</p>
          @if (failure.retryable) {
            <button mat-stroked-button type="button" class="retry" [disabled]="busy()" (click)="retry()">
              {{ 'common.retry' | translate }}
            </button>
          }
        </div>
      }

      <button mat-flat-button type="submit" class="save" [disabled]="busy()">
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
  /** Saves the value (the API call); its result is passed on through `saved`. */
  readonly submitter = input.required<(value: PersonFormValue) => Observable<unknown>>();
  readonly saved = output<unknown>();
  /**
   * A contributor adding people from their link (Task 16), not the admin: no private notes, no
   * connection note and no "Connected to" picker (the connection is always to the contributor).
   * The strength is still required.
   */
  readonly contributor = input(false);
  /** Where tag suggestions come from; the admin's `/tags` when not given. */
  readonly suggestSource = input<TagSuggest | null>(null);

  private readonly fb = inject(FormBuilder).nonNullable;
  // Looked up on first use: a contributor's form never needs the admin client (or its session).
  private readonly injector = inject(Injector);
  private readonly drafts = inject(DraftStore);
  private readonly router = inject(Router);
  private readonly cdr = inject(ChangeDetectorRef);

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
    const draft = parseFormValue(this.drafts.load(this.draftKey()));
    if (draft) {
      this.apply(draft);
      this.draftRestored.set(true);
    } else {
      this.apply(this.startingValue());
    }
    this.moreOpen.set(hasOptionalValues(this.currentValue()));
  }

  protected onToggle(event: Event): void {
    this.moreOpen.set((event.target as HTMLDetailsElement).open);
  }

  protected toggleAvailableFor(option: AvailableFor, checked: boolean): void {
    const control = this.form.controls.availableFor;
    const rest = control.value.filter((v) => v !== option);
    control.setValue(checked ? [...rest, option] : rest);
  }

  protected addSocialLink(kind: SocialLinkKind = 'facebook', url = ''): void {
    this.socialLinks.push(this.fb.group({ kind: this.fb.control(kind), url: this.fb.control(url) }));
  }

  protected addContact(kind: ContactKind = 'phone', value = ''): void {
    this.contacts.push(this.fb.group({ kind: this.fb.control(kind), value: this.fb.control(value) }));
  }

  protected async pickFromContacts(): Promise<void> {
    const picked = await pickContact();
    if (!picked) return;
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
    this.apply(this.startingValue());
    this.draftRestored.set(false);
    this.error.set(null);
    this.moreOpen.set(hasOptionalValues(this.currentValue()));
  }

  protected submit(): void {
    if (this.busy()) return;
    this.submitAttempted.set(true);
    if (this.form.invalid) return;
    this.send();
  }

  protected retry(): void {
    if (!this.busy()) this.send();
  }

  private send(): void {
    const value = this.currentValue();
    this.busy.set(true);
    this.error.set(null);
    this.submitter()(value).subscribe({
      next: (result) => {
        this.busy.set(false);
        this.drafts.clear(this.draftKey());
        this.saved.emit(result);
      },
      error: (failure: unknown) => this.onFailure(failure, value),
    });
  }

  private onFailure(failure: unknown, value: PersonFormValue): void {
    const apiError = toApiError(failure);
    this.busy.set(false);
    // Keep the entry for a network or server failure (nothing about the data was refused), and
    // for a lapsed MFA step: the admin is sent to /mfa and must find their input on return.
    // Any other rejection (a 4xx about the data) never saves a draft.
    const mfaRequired = apiError.code === 'mfa_required';
    const message = personErrorMessage(apiError);
    if (message.retryable || mfaRequired) this.drafts.save(this.draftKey(), value);
    if (mfaRequired) {
      void this.router.navigateByUrl('/mfa');
      return;
    }
    this.error.set(message);
    this.cdr.markForCheck();
  }

  private addContactOnce(kind: ContactKind, value: string): void {
    const exists = this.contacts.controls.some(
      (row) => row.controls.kind.value === kind && row.controls.value.value.trim() === value,
    );
    if (!exists) this.addContact(kind, value);
  }

  private startingValue(): PersonFormValue {
    return { ...emptyPersonFormValue(), ...(this.initial() ?? {}) };
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

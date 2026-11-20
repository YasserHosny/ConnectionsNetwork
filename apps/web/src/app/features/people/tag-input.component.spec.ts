import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { Observable, of } from 'rxjs';

import { LocaleService } from '../../core/locale.service';
import { loadCatalogues } from '../../testing/test-helpers';
import { type TagSuggestion } from './person-form.model';
import { TagInputComponent } from './tag-input.component';

describe('TagInputComponent', () => {
  let fixture: ComponentFixture<TagInputComponent>;
  let suggest: jasmine.Spy<(kind: string, q: string) => Observable<TagSuggestion[]>>;

  const el = () => fixture.nativeElement as HTMLElement;
  const input = () => el().querySelector('input') as HTMLInputElement;
  const addButton = () => el().querySelector('button.add') as HTMLButtonElement;

  function create(kind: 'skill' | 'industry'): void {
    fixture = TestBed.createComponent(TagInputComponent);
    fixture.componentRef.setInput('kind', kind);
    fixture.componentRef.setInput('suggest', suggest);
    fixture.detectChanges();
  }

  function typeText(text: string): void {
    input().value = text;
    input().dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  function chooseCategory(category: string): void {
    const select = el().querySelector('select.category') as HTMLSelectElement;
    select.value = category;
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  }

  beforeEach(() => {
    localStorage.clear();
    suggest = jasmine.createSpy('suggest').and.returnValue(of([]));
    TestBed.configureTestingModule({ providers: [provideTranslateService()] });
    loadCatalogues();
    TestBed.inject(LocaleService).setLocale('en');
  });

  afterEach(() => localStorage.clear());

  it('adds a skill with the chosen category', () => {
    create('skill');
    typeText('Python');
    chooseCategory('technical');

    addButton().click();
    fixture.detectChanges();

    expect(fixture.componentInstance.value()).toEqual([
      { label: 'Python', category: 'technical', level: null },
    ]);
    expect(el().querySelector('.chips')?.textContent).toContain('Python');
    expect(input().value).toBe('');
  });

  it('does not add a skill without a category', () => {
    create('skill');
    typeText('Python');

    addButton().click();
    fixture.detectChanges();

    expect(fixture.componentInstance.value()).toEqual([]);
    expect(el().querySelector('[role=alert]')?.textContent).toContain('Choose a category');
  });

  it('sets the level of a skill chip and can clear it again', () => {
    create('skill');
    typeText('Python');
    chooseCategory('technical');
    addButton().click();
    fixture.detectChanges();

    const level = el().querySelector('select.level') as HTMLSelectElement;
    level.value = 'expert';
    level.dispatchEvent(new Event('change'));
    expect(fixture.componentInstance.value()[0].level).toBe('expert');

    level.value = '';
    level.dispatchEvent(new Event('change'));
    expect(fixture.componentInstance.value()[0].level).toBeNull();
  });

  it('adds an industry by label only, without duplicates', () => {
    create('industry');
    typeText('Banking');
    addButton().click();
    fixture.detectChanges();
    typeText('banking');
    addButton().click();
    fixture.detectChanges();

    expect(el().querySelector('select.category')).toBeNull();
    expect(fixture.componentInstance.value()).toEqual([
      { label: 'Banking', category: null, level: null },
    ]);
  });

  it('removes a chip', () => {
    create('industry');
    typeText('Banking');
    addButton().click();
    fixture.detectChanges();

    (el().querySelector('button.remove') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(fixture.componentInstance.value()).toEqual([]);
  });

  it('asks for suggestions after a pause, and a suggestion fills in its category', fakeAsync(() => {
    suggest.and.returnValue(of([{ label: 'Python', category: 'technical' }]));
    create('skill');

    typeText('Pyt');
    typeText('Pyth');
    expect(suggest).not.toHaveBeenCalled();
    tick(300);

    expect(suggest).toHaveBeenCalledTimes(1);
    expect(suggest).toHaveBeenCalledWith('skill', 'Pyth');

    fixture.componentInstance['applySuggestion']({ label: 'Python', category: 'technical' });
    fixture.detectChanges();
    expect((el().querySelector('select.category') as HTMLSelectElement).value).toBe('technical');
    expect(input().value).toBe('Python');
  }));
});

import { Pipe, PipeTransform } from '@angular/core';

/** FIRST STRONG ISOLATE and POP DIRECTIONAL ISOLATE (Unicode bidi isolates). */
const FSI = '⁨';
const PDI = '⁩';

/**
 * A name set inside a sentence of the other script, kept in its own direction: "Keep Sara?" in
 * Arabic, or an Arabic name in an English message, otherwise reorders around the punctuation next
 * to it. Every person or contributor name interpolated into an i18n message goes through this.
 */
export function isolate(text: string): string {
  return text ? `${FSI}${text}${PDI}` : text;
}

/** `isolate` for templates: `{{ 'key' | translate: { name: (person.name | isolate) } }}`. */
@Pipe({ name: 'isolate' })
export class IsolatePipe implements PipeTransform {
  transform(text: string | null | undefined): string {
    return isolate(text ?? '');
  }
}

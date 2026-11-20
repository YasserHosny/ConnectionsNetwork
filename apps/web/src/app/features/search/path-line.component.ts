import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type { PathNode } from '@connections/domain-types';

import { IsolatePipe } from '../../core/bidi';

/**
 * A path as a line: "You ← Ahmed ← Karim ← Sara" (spec 8.6). The owner comes first and is shown as
 * "You"; everyone else links to their page. The arrow points back toward you, so it flips in RTL.
 */
@Component({
  selector: 'app-path-line',
  imports: [RouterLink, TranslatePipe, IsolatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ol class="path-line" [attr.aria-label]="'search.path.label' | translate: { name: (targetName() | isolate) }">
      <li class="you">{{ 'search.path.you' | translate }}</li>
      @for (node of others(); track $index) {
        <li>
          <span class="sep" aria-hidden="true">←</span>
          <a [routerLink]="['/people', node.person_id]">{{ node.display_name }}</a>
        </li>
      }
    </ol>
  `,
  styles: `
    .path-line {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 4px 8px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      display: inline-flex;
      gap: 8px;
    }
    .you {
      font-weight: 600;
    }
    .sep {
      color: var(--mat-sys-on-surface-variant);
    }
    :host-context([dir='rtl']) .sep {
      display: inline-block;
      transform: scaleX(-1);
    }
  `,
})
export class PathLineComponent {
  readonly path = input.required<readonly PathNode[]>();

  protected readonly others = computed(() => this.path().slice(1));
  protected readonly targetName = computed(() => this.path().at(-1)?.display_name ?? '');
}

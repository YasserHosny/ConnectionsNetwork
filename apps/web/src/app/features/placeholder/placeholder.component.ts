import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';

/** Stands in for a page a later task builds; the route supplies its title key as `titleKey`. */
@Component({
  selector: 'app-placeholder',
  imports: [TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>{{ titleKey | translate }}</h1>
    <p>{{ 'common.comingSoon' | translate }}</p>
  `,
})
export class PlaceholderComponent {
  protected readonly titleKey = inject(ActivatedRoute).snapshot.data['titleKey'] as string;
}

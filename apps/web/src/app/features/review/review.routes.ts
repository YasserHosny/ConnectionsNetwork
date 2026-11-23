import type { Routes } from '@angular/router';

/** /review: the tab container with a list per child route; it opens on the duplicates. */
export const REVIEW_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./review.page').then((m) => m.ReviewPage),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'duplicates' },
      {
        path: 'duplicates',
        loadComponent: () => import('./duplicates.page').then((m) => m.DuplicatesPage),
      },
      { path: 'stale', loadComponent: () => import('./stale.page').then((m) => m.StalePage) },
      {
        path: 'unreachable',
        loadComponent: () => import('./unreachable.page').then((m) => m.UnreachablePage),
      },
    ],
  },
];

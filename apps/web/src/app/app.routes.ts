import { Routes } from '@angular/router';

import { mfaGuard } from './core/mfa.guard';

/**
 * One pathless parent carries `mfaGuard`, so it judges every navigation: it lets /login, /mfa
 * and /c through and sends the rest to sign-in or MFA.
 */
export const routes: Routes = [
  {
    path: '',
    canActivateChild: [mfaGuard],
    children: [
      {
        path: 'login',
        loadComponent: () =>
          import('./features/auth/login.component').then((m) => m.LoginComponent),
      },
      {
        path: 'mfa',
        loadComponent: () => import('./features/auth/mfa.component').then((m) => m.MfaComponent),
      },
      {
        path: 'c',
        loadComponent: () =>
          import('./features/contribute/contribute.component').then((m) => m.ContributeComponent),
      },
      {
        path: '',
        loadComponent: () => import('./layout/shell.component').then((m) => m.ShellComponent),
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'search' },
          {
            path: 'search',
            loadComponent: () => import('./features/search/search.page').then((m) => m.SearchPage),
          },
          {
            path: 'add',
            loadComponent: () =>
              import('./features/people/add-person.page').then((m) => m.AddPersonPage),
          },
          {
            path: 'people/:id/edit',
            loadComponent: () =>
              import('./features/people/edit-person.page').then((m) => m.EditPersonPage),
          },
          {
            path: 'people/:id',
            loadComponent: () => import('./features/people/person.page').then((m) => m.PersonPage),
          },
          {
            path: 'review',
            loadChildren: () => import('./features/review/review.routes').then((m) => m.REVIEW_ROUTES),
          },
          {
            path: 'links',
            loadComponent: () => import('./features/links/links.page').then((m) => m.LinksPage),
          },
          {
            path: 'export',
            loadComponent: () =>
              import('./features/export/export.page').then((m) => m.ExportPage),
          },
        ],
      },
      { path: '**', redirectTo: '' },
    ],
  },
];

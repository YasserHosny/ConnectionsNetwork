import { Routes } from '@angular/router';

import { mfaGuard } from './core/mfa.guard';

const placeholder = (titleKey: string) => ({
  loadComponent: () =>
    import('./features/placeholder/placeholder.component').then((m) => m.PlaceholderComponent),
  data: { titleKey },
});

/**
 * One pathless parent carries `mfaGuard`, so it judges every navigation: it lets /login, /mfa
 * and /c through and sends the rest to sign-in or MFA. Later tasks replace the placeholders.
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
          { path: 'search', ...placeholder('pages.search.title') },
          { path: 'add', ...placeholder('pages.add.title') },
          { path: 'review', ...placeholder('pages.review.title') },
          { path: 'links', ...placeholder('pages.links.title') },
          { path: 'export', ...placeholder('pages.export.title') },
        ],
      },
      { path: '**', redirectTo: '' },
    ],
  },
];

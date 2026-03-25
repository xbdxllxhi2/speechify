import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'library',
    pathMatch: 'full',
  },
  {
    path: 'library',
    loadComponent: () =>
      import('./features/library/library.component').then((m) => m.LibraryComponent),
  },
  {
    path: 'reader/:id',
    loadComponent: () =>
      import('./features/reader/reader.component').then((m) => m.ReaderComponent),
  },
  {
    path: '**',
    redirectTo: 'library',
  },
];

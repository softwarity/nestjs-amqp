import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./pages/getting-started.component').then((m) => m.GettingStartedComponent),
  },
  {
    path: 'configuration',
    loadComponent: () => import('./pages/configuration.component').then((m) => m.ConfigurationComponent),
  },
  {
    path: 'broker-topology',
    loadComponent: () => import('./pages/broker-topology.component').then((m) => m.BrokerTopologyComponent),
  },
  {
    path: 'publishers',
    loadComponent: () => import('./pages/publishers.component').then((m) => m.PublishersComponent),
  },
  {
    path: 'consumers',
    loadComponent: () => import('./pages/consumers.component').then((m) => m.ConsumersComponent),
  },
  {
    path: 'parameter-decorators',
    loadComponent: () => import('./pages/parameter-decorators.component').then((m) => m.ParameterDecoratorsComponent),
  },
  {
    path: 'codec',
    loadComponent: () => import('./pages/codec.component').then((m) => m.CodecComponent),
  },
  {
    path: 'dlq-browser',
    loadComponent: () => import('./pages/dlq-browser.component').then((m) => m.DlqBrowserComponent),
  },
  {
    path: 'errors-lifecycle',
    loadComponent: () => import('./pages/errors-lifecycle.component').then((m) => m.ErrorsLifecycleComponent),
  },
  { path: '**', redirectTo: '' },
];

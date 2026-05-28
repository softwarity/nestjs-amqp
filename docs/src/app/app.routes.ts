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
    path: 'publishers',
    loadComponent: () => import('./pages/publishers.component').then((m) => m.PublishersComponent),
  },
  {
    path: 'consumers',
    loadComponent: () => import('./pages/consumers.component').then((m) => m.ConsumersComponent),
  },
  {
    path: 'request-reply',
    loadComponent: () => import('./pages/request-reply.component').then((m) => m.RequestReplyComponent),
  },
  {
    path: 'retry-and-dlq',
    loadComponent: () => import('./pages/retry-and-dlq.component').then((m) => m.RetryAndDlqComponent),
  },
  {
    path: 'multi-broker',
    loadComponent: () => import('./pages/multi-broker.component').then((m) => m.MultiBrokerComponent),
  },
  {
    path: 'parameter-decorators',
    loadComponent: () => import('./pages/parameter-decorators.component').then((m) => m.ParameterDecoratorsComponent),
  },
  {
    path: 'serialization',
    loadComponent: () => import('./pages/serialization.component').then((m) => m.SerializationComponent),
  },
  {
    path: 'dlq-browser',
    loadComponent: () => import('./pages/dlq-browser.component').then((m) => m.DlqBrowserComponent),
  },
  {
    path: 'broker-topology',
    loadComponent: () => import('./pages/broker-topology.component').then((m) => m.BrokerTopologyComponent),
  },
  {
    path: 'errors-lifecycle',
    loadComponent: () => import('./pages/errors-lifecycle.component').then((m) => m.ErrorsLifecycleComponent),
  },
  { path: '**', redirectTo: '' },
];

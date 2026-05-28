import { Component, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';

interface DocLink {
  path: string;
  label: string;
  icon: string;
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatIconModule],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent {
  protected readonly links: DocLink[] = [
    { path: '/', label: 'Getting started', icon: 'rocket_launch' },
    { path: '/configuration', label: 'Configuration', icon: 'settings' },
    { path: '/publishers', label: 'Publishers', icon: 'send' },
    { path: '/consumers', label: 'Consumers', icon: 'inbox' },
    { path: '/request-reply', label: 'Request / reply', icon: 'swap_horiz' },
    { path: '/retry-and-dlq', label: 'Retry & DLQ', icon: 'replay' },
    { path: '/multi-broker', label: 'Multi-broker', icon: 'hub' },
    { path: '/parameter-decorators', label: 'Parameter decorators', icon: 'tune' },
    { path: '/serialization', label: 'Serialization', icon: 'data_object' },
    { path: '/dlq-browser', label: 'DLQ browser', icon: 'manage_search' },
    { path: '/broker-topology', label: 'Broker topology', icon: 'lan' },
    { path: '/errors-lifecycle', label: 'Errors & lifecycle', icon: 'event_repeat' },
  ];
}

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  viewChild,
} from '@angular/core';
import Prism from 'prismjs';
// Side-effect imports register the languages on the global Prism instance.
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';

export type CodeLang = 'ts' | 'typescript' | 'bash' | 'shell' | 'json' | 'text';

/**
 * Renders a Prism-highlighted code block with the Catppuccin Mocha theme.
 *
 * Usage:
 * ```html
 * <app-code lang="ts">{{ snippet }}</app-code>
 * <app-code lang="bash">npm install</app-code>
 * ```
 *
 * The code is passed via `<ng-content>` so multi-line template literals stay
 * readable in the page source.
 */
@Component({
  selector: 'app-code',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <pre class="code-block" [class]="'language-' + lang()"><code #codeEl [class]="'language-' + lang()"><ng-content /></code></pre>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .code-block {
        margin: 0 0 16px 0;
      }
    `,
  ],
})
export class CodeComponent implements AfterViewInit {
  readonly lang = input<CodeLang>('ts');
  private readonly codeEl = viewChild.required<ElementRef<HTMLElement>>('codeEl');

  ngAfterViewInit(): void {
    Prism.highlightElement(this.codeEl().nativeElement);
  }
}

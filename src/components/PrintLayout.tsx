import type { PrintLayout } from '@/domain/records';

/**
 * Applies a clinic's versioned print layout. Only structured values are used (no clinic-supplied HTML or CSS),
 * so a layout cannot inject script or styles. With pre-printed stationery the on-screen header is kept for
 * reference but hidden on paper, and blank space is reserved at the top and bottom instead.
 */
export function PrintLayoutStyle({ layout, scope }: { layout: PrintLayout; scope: string }) {
  const hideHeadOnPaper = !layout.showHeader || layout.preprintedTopMm > 0;
  const css = `
@page { size: ${layout.paper}; margin: ${layout.marginMm}mm; }
.${scope} { --accent: ${layout.accent}; font-size: ${Math.round(layout.fontScale * 100)}%; }
.${scope} .print-head { text-align: ${layout.headerAlign}; border-bottom-color: var(--accent); ${layout.headerAlign === 'center' ? 'justify-content: center; flex-direction: column;' : ''} }
.${scope} .print-head h1, .${scope} h2.rx-symbol { color: var(--accent); }
${layout.showLogo ? '' : `.${scope} .print-head img { display: none; }`}
.${scope} .pp-top { height: ${layout.preprintedTopMm}mm; } .${scope} .pp-bottom { height: ${layout.preprintedBottomMm}mm; }
@media screen { .${scope} .pp-top, .${scope} .pp-bottom { display: none; } }
@media print { ${hideHeadOnPaper ? `.${scope} .print-head { display: none !important; }` : ''} .${scope} { border: 0 !important; max-width: none !important; padding: 0 !important; } }`;
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}

export function HeaderLines({ layout }: { layout: PrintLayout }) {
  return <>{layout.extraHeaderLines.filter(Boolean).map((l, i) => <p key={i} className="small">{l}</p>)}</>;
}

export function LayoutFooter({ layout, version }: { layout: PrintLayout; version: number }) {
  return (
    <>
      {layout.signatureLabel && <p className="sig-line">{layout.signatureLabel}</p>}
      {layout.footerText && <p className="small prewrap">{layout.footerText}</p>}
      {version > 0 && <p className="tiny muted">Layout v{version}</p>}
      <div className="pp-bottom" />
    </>
  );
}

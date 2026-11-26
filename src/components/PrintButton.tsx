'use client';
export function PrintButton() {
  return <button className="btn no-print" type="button" onClick={() => window.print()}>Print</button>;
}

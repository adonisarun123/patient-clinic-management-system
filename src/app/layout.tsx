import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: 'Clinic Core', description: 'Patient management add-on for clinics and hospitals' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

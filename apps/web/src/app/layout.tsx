import type { Metadata } from 'next';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'InfraSim — Cloud Architecture Load Simulator',
  description:
    'Design cloud infrastructure on a canvas, attach mock code, and watch how services behave under simulated load.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <body className="font-sans antialiased selection:bg-[var(--accent-soft)] selection:text-[var(--text-primary)]">
        {children}
      </body>
    </html>
  );
}

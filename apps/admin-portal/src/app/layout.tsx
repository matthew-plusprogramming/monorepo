import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import type { JSX } from 'react';

import { ReactQueryProvider } from '@/providers/QueryClientProvider';

import './globals.scss';

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-inter',
});

export const metadata: Metadata = {
  title: 'Client App',
  description: 'Our client website.',
};

const RootLayout = ({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): JSX.Element => {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <ReactQueryProvider>{children}</ReactQueryProvider>
      </body>
    </html>
  );
};

export default RootLayout;

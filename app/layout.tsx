import type { Metadata } from "next";
import "./globals.css";

const SITE_NAME = "Job Scout";
const SITE_DESC = "A lightweight job scout webapp powered by scheduled Workday scrapes.";
const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://example.vercel.app";

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    default: SITE_NAME,
    template: `%s · ${SITE_NAME}`
  },
  description: SITE_DESC,
  alternates: {
    canonical: "/jobs"
  },
  openGraph: {
    title: SITE_NAME,
    description: SITE_DESC,
    type: "website",
    url: "/jobs"
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_NAME,
    description: SITE_DESC
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true
    }
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body>
        <header className="header">
          <div className="headerInner">
            <div className="brand">Job Scout</div>
            <nav className="nav">
              <a className="navLink" href="/jobs">
                Jobs
              </a>
              <a className="navLink" href="/changes">
                Changes
              </a>
              <a className="navLink" href="/rss.xml" target="_blank" rel="noreferrer">
                RSS
              </a>
              <a className="navLink" href="/jobs.json" target="_blank" rel="noreferrer">
                JSON
              </a>
              <a className="navLink" href="/jobs.csv" target="_blank" rel="noreferrer">
                CSV
              </a>
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}

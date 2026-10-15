import type { Metadata, Viewport } from "next";
import "./style.css";
export const viewport: Viewport = { themeColor: "#2B3675" };
export const metadata: Metadata = {
  title: "Temperance · Family balance",
  description: "Open source family VPN controls. Your rules, your data.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

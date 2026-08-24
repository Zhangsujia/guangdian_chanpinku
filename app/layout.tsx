import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "产品链接管家",
  description: "通过中文聊天管理产品、平台链接与销售机制。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

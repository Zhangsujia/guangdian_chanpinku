import { getSessionMember, isSameOrigin } from "../../auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "请求来源无效" }, { status: 403 });
  const user = await getSessionMember(request);
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });
  if (user.mustChangePassword) return Response.json({ error: "请先修改临时密码" }, { status: 403 });

  const payload = await request.json() as { url?: string };
  const raw = String(payload.url ?? "").trim();
  if (!raw) return Response.json({ kind: "unreachable", message: "链接为空", status: 0 });
  const target = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : /^(?:[\w-]+\.)+[a-z]{2,}(?:\/|$)/i.test(raw)
      ? `https://${raw}`
      : null;
  if (!target || !/^https?:\/\//i.test(target)) {
    return Response.json({ kind: "manual", message: "该链接不是网页地址，请复制后在对应平台人工确认", status: 0 });
  }
  try {
    let response = await fetch(target, { method: "HEAD", redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 ProductLinkAssistant/2.0" } });
    if (response.status === 405) response = await fetch(target, { method: "GET", redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 ProductLinkAssistant/2.0" } });
    const status = response.status;
    if (status >= 200 && status < 400) return Response.json({ kind: "reachable", message: "网页可以访问，商品与佣金状态仍建议人工确认", status });
    if ([401, 403, 429].includes(status)) return Response.json({ kind: "protected", message: "平台限制了自动检测，请人工打开确认", status });
    if ([404, 410].includes(status)) return Response.json({ kind: "suspected", message: `网页返回 ${status}，链接疑似失效`, status });
    return Response.json({ kind: "unreachable", message: `网页返回状态码 ${status}，请人工复核`, status });
  } catch {
    return Response.json({ kind: "unreachable", message: "暂时无法访问，请人工确认", status: 0 });
  }
}

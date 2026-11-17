// 나이스파크 Cloudflare 입구: 모든 요청을 Flask 서버 컨테이너 하나로 넘긴다.
import { Container } from "@cloudflare/containers";

interface Env {
  APP: DurableObjectNamespace<ParkgolfApp>;
  // Cloudflare 화면의 '변수 및 비밀'에 넣는 값들
  SECRET_KEY?: string;
  DATABASE_URL?: string;
  KAKAO_REST_API_KEY?: string;
  KAKAO_CLIENT_SECRET?: string;
  ADMIN_KAKAO_IDS?: string;
}

const PASS_THROUGH = ["SECRET_KEY", "DATABASE_URL", "KAKAO_REST_API_KEY", "KAKAO_CLIENT_SECRET", "ADMIN_KAKAO_IDS"] as const;

export class ParkgolfApp extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "15m"; // 15분 동안 접속이 없으면 잠들어 요금 절약 (깨어날 때 몇 초)

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    const vars: Record<string, string> = { CLOUDFLARE: "1" };
    for (const k of PASS_THROUGH) if (env[k]) vars[k] = env[k] as string;
    this.envVars = vars;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set("X-Forwarded-Proto", url.protocol.replace(":", ""));
    headers.set("X-Forwarded-Host", url.host);
    const ip = request.headers.get("CF-Connecting-IP");
    if (ip) headers.set("X-Forwarded-For", ip);
    const req = new Request(request, { headers });
    return env.APP.getByName("main").fetch(req);
  },
} satisfies ExportedHandler<Env>;

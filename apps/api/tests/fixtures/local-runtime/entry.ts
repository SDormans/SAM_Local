// T001 feasibility fixture: the real ProjectData Durable Object plus D1, served by local workerd.
export { ProjectData } from '../../../src/durable-objects/project-data';
interface Env {
  PROJECT_DATA: DurableObjectNamespace;
  DATABASE: D1Database;
}
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const stub = env.PROJECT_DATA.get(env.PROJECT_DATA.idFromName('feasibility-project')) as any;
    if (url.pathname === '/write') {
      await env.DATABASE.prepare(
        'create table if not exists feasibility_probe (k text primary key, v text)'
      ).run();
      await env.DATABASE.prepare("insert or replace into feasibility_probe values ('probe', ?)")
        .bind(url.searchParams.get('v'))
        .run();
      const id = await stub.createSession(null, 'feasibility ' + url.searchParams.get('v'));
      return Response.json({ sessionId: id });
    }
    const row = await env.DATABASE.prepare(
      "select v from feasibility_probe where k='probe'"
    ).first();
    const sessions = await stub.listSessions(null, 10, 0);
    return Response.json({
      d1: row,
      total: sessions.total,
      topics: sessions.sessions.map((s: any) => s.topic),
    });
  },
};

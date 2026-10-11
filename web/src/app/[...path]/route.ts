import { handle } from '@/lib/http';
export const dynamic='force-dynamic';
export const runtime='nodejs';
async function route(request:Request,context:{params:Promise<{path:string[]}>}) {const {path}=await context.params;return handle(request,path.join('/'));}
export const GET=route;
export const POST=route;

import { ApiError, readJson } from './shared.js';
import { atLeast } from './client-policy.js';

export const CHAT_CLIENT='0.7.0';
export function chatStub(env) {
  if(!env.CHAT || env.CHAT_ENABLED!=='true') throw new ApiError(503,'Chat is unavailable. Ranked battles remain available.');
  return env.CHAT.get(env.CHAT.idFromName('lobby-v1'));
}
export async function chatRoute(request,env,db,me,path) {
  if(path!=='/chat/socket')return null;
  if(request.method!=='GET' || request.headers.get('Upgrade')?.toLowerCase()!=='websocket')throw new ApiError(400,'WebSocket required.');
  const version=request.headers.get('X-FTD-Rank-Version');
  if(!atLeast(version,CHAT_CLIENT))throw new ApiError(426,'Chat requires mod '+CHAT_CLIENT+'.');
  // Do not forward client-provided identity headers, URL credentials or session tokens.
  const identity={id:me.id,name:me.name,nicknameColor:me.nickname_color??null,revision:me.auth_revision,expires:me.token_expires,version};
  return chatStub(env).fetch(new Request('https://chat.internal/socket',{headers:{Upgrade:'websocket','X-Chat-Identity':encodeURIComponent(JSON.stringify(identity))}}));
}
export async function adminChatRoute(request,env,path) {
  if(!path.startsWith('/admin/chat'))return null;
  const url=new URL(request.url);
  const suffix=path.slice('/admin/chat'.length)||'/status';
  if(!['/status','/settings','/logs','/channels','/mute','/hide','/notice','/ticket'].includes(suffix))throw new ApiError(404,'Unknown chat action.');
  // Parent adminRoute already authenticated the administrator.
  const body=request.method==='GET'?undefined:JSON.stringify(await readJson(request,16384));
  return chatStub(env).fetch(new Request('https://chat.internal/admin'+suffix+url.search,
    {method:request.method,headers:{'Content-Type':'application/json'},body}));
}
export async function adminChatSocket(request,env) {
  const url=new URL(request.url);
  if(request.method!=='GET'||request.headers.get('Upgrade')?.toLowerCase()!=='websocket')throw new ApiError(400,'WebSocket required.');
  if((url.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))||request.headers.get('Origin')!==url.origin)
    throw new ApiError(403,'Open chat from the administrator page.');
  // Browsers cannot attach an Authorization header to WebSockets. Exchange an
  // authenticated, single-use 60-second ticket; never put the admin key in a URL.
  const ticket=url.searchParams.get('ticket')||'';
  if(!/^[a-f0-9]{64}$/.test(ticket))throw new ApiError(401,'Open administrator chat again.');
  return chatStub(env).fetch(new Request('https://chat.internal/viewer/socket?ticket='+ticket,{headers:{Upgrade:'websocket'}}));
}

import assert from "node:assert/strict";
import { chromium } from "playwright";
import { WebSocket } from "ws";
import { makeToken } from "../server/auth.ts";
const base=process.env.BASE||"http://127.0.0.1:7071";
const ws=new WebSocket(base.replace("http","ws")+"/ws",{headers:{origin:base,cookie:`ac_session=${makeToken()}`}});
const inbox:any[]=[];ws.on("message",d=>inbox.push(JSON.parse(String(d))));
async function wait(pred:(m:any)=>boolean){for(let i=0;i<250;i++){const at=inbox.findIndex(pred);if(at>=0)return inbox.splice(at,1)[0];await new Promise(r=>setTimeout(r,20));}throw Error("WS timeout");}
const hello=await wait(m=>m.t==="hello");const browser=await chromium.launch();const ids:string[]=[];
try {
  for(const width of [1280,390]){
    ws.send(JSON.stringify({t:"create",provider:"mock",cwd:hello.dirs[0],title:`Slash UI ${width}`}));const id=(await wait(m=>m.t==="created")).thread.id;ids.push(id);
    const ctx=await browser.newContext({viewport:{width,height:900},isMobile:width===390,hasTouch:width===390});await ctx.addCookies([{name:"ac_session",value:makeToken(),url:base}]);await ctx.addInitScript(id=>localStorage.setItem("ac_thread",id),id);
    const page=await ctx.newPage();const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));await page.goto(base);await page.waitForFunction(()=>!(document.querySelector("#input") as HTMLTextAreaElement)?.disabled);
    await page.fill("#input","/");await page.waitForSelector("#slash:not([hidden])");assert.ok(await page.locator("#slash .cmd",{hasText:"/compact"}).count());
    await page.fill("#input","remember the original fact");await page.click("#send");await page.waitForSelector(".msg.asst");await page.waitForFunction(()=>document.querySelector("#stop")?.hasAttribute("hidden"));
    await page.fill("#input","/com");await page.locator("#input").press("Tab");assert.equal(await page.locator("#input").inputValue(),"/compact ");await page.locator("#input").press("Enter");
    await page.waitForSelector(".command-note:has-text('Context compacted')");assert.equal(await page.locator(".msg.asst").count(),1);assert.match(await page.locator("#chat").innerText(),/remember the original fact/);assert.equal(await page.locator("#ctx .pct").innerText(),"3%");
    await page.fill("#input","/model");await page.locator("#input").press("Enter");await page.waitForSelector(".menu[role=listbox]");await page.keyboard.press("Escape");
    await page.fill("#input","/help");await page.locator("#input").press("Enter");await page.waitForSelector(".command-note:has-text('/compact')");assert.equal(await page.locator(".msg.asst").count(),1);
    await page.click("#more");await page.getByRole("menuitem",{name:/Compact context/}).click();await page.waitForFunction(()=>document.querySelectorAll(".command-note").length>=5);await page.waitForFunction(()=>document.querySelector("#stop")?.hasAttribute("hidden"));
    await page.reload();await page.waitForSelector(".command-note:has-text('Context compacted')");assert.equal(await page.locator(".msg.asst").count(),1);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);console.log(`PASS ${width}px slash menu before first turn, completion+Enter, native compaction, model/help commands, header action, transcript and reload`);await ctx.close();
  }
}finally{for(const id of ids)ws.send(JSON.stringify({t:"delete",thread:id}));ws.close();await browser.close();}

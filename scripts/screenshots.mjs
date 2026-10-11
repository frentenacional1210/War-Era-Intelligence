import {chromium} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
const base=process.env.WINT_URL ?? 'http://127.0.0.1:8787';
const browser=await chromium.launch({channel:process.env.WINT_BROWSER_CHANNEL ?? 'msedge'});
await mkdir('artifacts',{recursive:true});
try{
  for(const [name,width,height] of [['desktop',1440,1100],['mobile',390,844]]){
    const page=await browser.newPage({viewport:{width,height}});
    await Promise.all([page.waitForResponse(r=>r.url().includes('/api/dashboard/summary')),page.goto(base)]);
    await page.getByRole('heading',{name:'Centro de mando',exact:true}).waitFor();
    await page.screenshot({path:`artifacts/dashboard-${name}.png`,fullPage:true});await page.close();
  }
}finally{await browser.close();}

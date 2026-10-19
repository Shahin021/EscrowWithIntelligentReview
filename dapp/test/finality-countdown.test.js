import {it,expect,vi} from 'vitest';
import {countdownLabel,mountFinalityCountdown} from '../src/workspace/finality-countdown.js';
it('counts from chain time and never treats zero as finalized',()=>{
 const w={available:true,current:'1000',deadline:'1120'};
 expect(countdownLabel(w,5)).toContain('1m 55s');
 expect(countdownLabel(w,120)).toContain('awaiting FINALIZED');
 expect(countdownLabel(w,999)).not.toContain('successfully');
});
it('does not invent a deadline or show 1970',()=>{
 expect(countdownLabel({available:true,current:'1000',deadline:'0'})).toContain('not set');
 expect(countdownLabel(null)).toContain('unavailable');
});
it('keeps counting beyond ninety seconds without RPC or page reconstruction and cancels on selection change',()=>{
 let elapsed=0,callback;const cancel=vi.fn();const element={textContent:''};
 const stop=mountFinalityCountdown(element,{available:true,current:'1000',deadline:'1600'},{now:()=>elapsed,schedule:fn=>{callback=fn;return 42;},cancel});
 expect(element.textContent).toContain('10m 00s');elapsed=120000;callback();expect(element.textContent).toContain('8m 00s');
 stop();expect(cancel).toHaveBeenCalledWith(42);elapsed=180000;callback();expect(element.textContent).toContain('8m 00s');
});
it('does not schedule a timer for unknown or expired windows',()=>{
 const schedule=vi.fn();mountFinalityCountdown({},{available:true,current:'1000',deadline:'0'},{schedule});
 mountFinalityCountdown({},{available:true,current:'1000',deadline:'999'},{schedule});expect(schedule).not.toHaveBeenCalled();
});

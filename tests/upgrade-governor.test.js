import { expect, it } from 'vitest';
import { FrameTimeGovernor } from '../src/core/FrameTimeGovernor.js';
import quality from '../src/data/quality.json';
it('steps resolution down within bounds, recovers slowly and respects hysteresis', () => {
 const governor = new FrameTimeGovernor(quality.resolutionGovernor); governor.reset({ fps: 60, minScale: 0.7 });
 for(let i=0;i<300;i++)governor.sample(45); expect(governor.scale).toBe(0.7);
 for(let i=0;i<100;i++)governor.sample(10); expect(governor.scale).toBe(0.7);
 for(let i=0;i<600;i++)governor.sample(10); expect(governor.scale).toBe(1);
 for(let i=0;i<500;i++)governor.sample(16.7); expect(governor.scale).toBe(1);
});
it('does no work when disabled and does not treat a deliberate battery cap as overload', () => {
 const governor = new FrameTimeGovernor(quality.resolutionGovernor); governor.reset({ fps: 30, minScale: 0.7 });
 for(let i=0;i<200;i++)governor.sample(33.3333); expect(governor.scale).toBe(1);
 governor.enabled = false; expect(governor.sample(100)).toBeNull(); expect(governor.scale).toBe(1);
});
it('recovers at the real 60Hz cap instead of requiring impossible >77fps intervals', () => {
 const governor=new FrameTimeGovernor(quality.resolutionGovernor);governor.reset({fps:60,minScale:.7});
 for(let i=0;i<300;i++)governor.sample(45);expect(governor.scale).toBe(.7);
 for(let i=0;i<900;i++)governor.sample(1000/60);expect(governor.scale).toBe(1);
});

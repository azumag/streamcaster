'use strict';
const Base=require('../../controller/blmf/coordinator');
// Manual scene cuts: observational NDI health must not prevent an operator cut.
// The production coordinator retains its readiness policy.
class ManualSceneCoordinator extends Base {
 async entry(generation){
  await this.mutate('main',()=>this.mainObs.setProgramScene(this.scenes.mainEntry),generation);
  this.check(generation);
  if(!await this.confirmProgram(this.mainObs,this.scenes.mainEntry,generation))return this.failure('program_not_confirmed');
  this.programView='ENTRY';
  return this.success();
 }
}
module.exports=ManualSceneCoordinator;

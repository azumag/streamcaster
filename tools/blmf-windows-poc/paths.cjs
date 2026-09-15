'use strict';
const path=require('path');
const home=path.resolve(process.env.BLMF_POC_HOME||path.join(__dirname,'.runtime'));
module.exports={home,control:path.join(home,'control'),main:path.join(home,'main'),sub:path.join(home,'sub')};

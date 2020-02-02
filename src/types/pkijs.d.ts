/* tslint:disable:no-implicit-dependencies no-submodule-imports */

declare module 'pkijs' {
  // Importing and exporting each member because "@types/pkijs" doesn't expose
  // the "pkijs" module -- it exports many individual modules. Also, the
  // following expression to export things in bulk didn't have any effect:
  //   export * from "pkijs/src/_x509";

  export { default as Certificate } from 'pkijs/src/Certificate';
  export { default as EnvelopedData } from 'pkijs/src/EnvelopedData';
}

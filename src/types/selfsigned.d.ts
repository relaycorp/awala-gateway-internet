declare module 'selfsigned' {
  export function generate(
    attrs: readonly object[],
    options: { readonly days: number; readonly extensions: readonly any[] },
  ): { readonly cert: string; readonly private: string };
}

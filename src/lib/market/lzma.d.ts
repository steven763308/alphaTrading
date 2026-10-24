declare module "lzma" {
  export function decompress(data: number[] | Uint8Array): string | number[];
}

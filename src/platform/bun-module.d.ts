declare module "bun" {
  export function file(path: string): {
    arrayBuffer(): Promise<ArrayBuffer>;
  };
}

declare module "*.node" {
  const addon: import("../binding.js").NativeAddon;
  export default addon;
}

declare module "*.dll" {
  const path: string;
  export default path;
}

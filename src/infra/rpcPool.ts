import { ethers } from 'ethers';

export class RpcPool {
  private idx = 0;
  private providers: ethers.providers.JsonRpcProvider[];

  constructor(urls: string[]) {
    this.providers = urls.map((u) => new ethers.providers.JsonRpcProvider(u));
  }

  current(): ethers.providers.JsonRpcProvider {
    return this.providers[this.idx];
  }

  rotate(): ethers.providers.JsonRpcProvider {
    this.idx = (this.idx + 1) % this.providers.length;
    return this.current();
  }
}



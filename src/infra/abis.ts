export const AIRDROP_ABI = [
  'function claim(address referrer) payable',
  // public vars (view)
  'function claimFee() view returns (uint256)',
  'function cooldown() view returns (uint256)',
  'function minReward() view returns (uint256)',
  'function maxReward() view returns (uint256)',
  'function feeRecipient() view returns (address)',
  'function token() view returns (address)',
  'event Claimed(address indexed user, uint256 amount)',
  'event ReferralReward(address indexed referrer, uint256 amount)',
  'event CooldownReset(address indexed referrer)',
];

export const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];



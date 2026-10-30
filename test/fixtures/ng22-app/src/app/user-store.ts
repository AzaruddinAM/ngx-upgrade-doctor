export interface User {
  id: number;
  name: string;
}

export class UserStore {
  users = [] as User[];
  count = 0;
  readonly label = 'users';
  private cache;

  add(user, notify?) {
    this.users.push(user);
    this.count++;
    return this.users.length;
  }

  names() {
    return this.users.map(u => u.name);
  }

  find(id: number) {
    return this.users.find((u) => u.id === id);
  }
}

export function total(...values) {
  let sum = 0;
  for (const v of values) {
    sum += v;
  }
  return sum;
}

export const double = x => x * 2;

import * as CryptoJS from 'crypto-js';

class TableSource<T> { constructor(public data: T[] = []) {} }
interface Panel { [key: string]: any }

export class ScoreComponent {
  bankarray: any[];
  isVisible: boolean;
  dataSource1: TableSource<any>;
  banking: string;
  otp: number;
  password: number;
  public webcamImage: TableSource<any> = null;
  panelClass: Set<string> | Panel = {};
  score: string;
  score1: string;
  private _value: string;
  optional?: string;
  ready = false;

  setScore(k: number, e: string): void {
    this[`score${k - 1 || ''}`] = e;
    const total = ['score', 'score1'].reduce((sum: any, key: any): any => sum + (Number(this[key]) || 0), 0);
    console.log(total, this.banking['cin'], CryptoJS);
  }

  reset(fields: any[], panel: any): void {
    fields.forEach((field: any): any => this[field] = '');
    this.otp = this.password = undefined;
    this.dataSource1 = undefined;
    this.panelClass[panel] = true;
  }
}

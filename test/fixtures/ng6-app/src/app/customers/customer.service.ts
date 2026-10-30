import { Injectable, Renderer } from '@angular/core';
import { Http } from '@angular/http';
import { Observable } from 'rxjs/Observable';
import { of } from 'rxjs/observable/of';
import { fromPromise } from 'rxjs/observable/fromPromise';
import { map } from 'rxjs/operators/map';
import 'rxjs/add/operator/catch';

@Injectable()
export class CustomerService {
  constructor(private http: Http) {}

  list(): Observable<any[]> {
    return this.http.get('/api/customers').pipe(map(r => r.json()));
  }
}

import { TestBed, async } from '@angular/core/testing';
import { CustomerService } from './customer.service';

describe('CustomerService', () => {
  beforeEach(async(() => {
    TestBed.configureTestingModule({ providers: [CustomerService] });
  }));

  it('creates', async () => {
    const svc = TestBed.get(CustomerService);
    expect(svc).toBeTruthy();
  });
});

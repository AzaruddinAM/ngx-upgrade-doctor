export class OrderDetailComponent {
  constructor(private router: any, private route: any) {}
  back(): void {
    this.router.navigate(['../list'], { relativeTo: this.route });
  }
  home(): void {
    this.router.navigate(['../../dashboard']);
  }
}

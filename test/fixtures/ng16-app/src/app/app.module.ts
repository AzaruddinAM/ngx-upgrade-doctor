import { NgModule } from '@angular/core';
import { HttpClientModule } from '@angular/common/http';
import { ScannerComponent } from './scanner.component';

@NgModule({
  declarations: [ScannerComponent],
  imports: [
    HttpClientModule,
    // HttpClientModule,
    HttpClientModule,
  ],
  providers: [],
})
export class AppModule {}

import { NgModule, ModuleWithProviders } from '@angular/core';
import { ConfirmDialogComponent } from './confirm-dialog.component';

@NgModule({
  declarations: [ConfirmDialogComponent],
  entryComponents: [ConfirmDialogComponent],
  exports: [ConfirmDialogComponent],
})
export class SharedModule {
  static forRoot(): ModuleWithProviders {
    return { ngModule: SharedModule, providers: [] };
  }
}

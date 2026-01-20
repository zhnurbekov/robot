/**
 * Интерфейс для обработки данных портала
 */
export interface IPortalProcessor {
	

	
	processUpdateInformationOnTaxArrears(data: any): Promise<any>;
	
	processGetPermits(data: any): Promise<any>;
	
	processAnnouncementSearch(data: any): Promise<any>;
	
	processAnnouncementCreate(data: any): Promise<any>;
	
	appendixHandle(announceId: string, applicationId: string, docId: string): Promise<any>;
	appendixSecondHandle(announceId: string, applicationId: string, docId: string): Promise<any>;
	copyingQualificationInformation(announceId: string, applicationId: string, docId: string): Promise<any>;
	addingBidSecurity(announceId: string, applicationId: string, docId: string, taskId: string): Promise<any>;
	obtainPermits(announceId: string, applicationId: string, docId: string): Promise<any>;
	getLotNUmber(announceId: string, applicationId: string, docId: string): Promise<any>;
	dataSheetHandle(announceId: string, applicationId: string, docId: string, lotId: string, index?: string): Promise<any>;
}













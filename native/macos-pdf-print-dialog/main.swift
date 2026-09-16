import AppKit
import PDFKit

let arguments = CommandLine.arguments
if arguments.count == 2 && arguments[1] == "--version" {
    print("evb-pdf-print-dialog 1")
    exit(0)
}
guard arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: pdf-print-dialog <path>\n".utf8))
    exit(64)
}

let sourceURL = URL(fileURLWithPath: arguments[1])
guard let document = PDFDocument(url: sourceURL) else {
    FileHandle.standardError.write(Data("unable to open PDF\n".utf8))
    exit(65)
}
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let requestedPrinterName = ProcessInfo.processInfo.environment["EVB_PRINT_DIALOG_PRINTER_NAME"]?.trimmingCharacters(in: .whitespacesAndNewlines)
let printInfo = NSPrintInfo.shared.copy() as! NSPrintInfo
if let requestedPrinterName, !requestedPrinterName.isEmpty {
    guard let printer = NSPrinter(name: requestedPrinterName) else {
        FileHandle.standardError.write(Data("unable to find requested printer\n".utf8))
        exit(67)
    }
    printInfo.printer = printer
}
guard let operation = document.printOperation(
    for: printInfo,
    scalingMode: .pageScaleToFit,
    autoRotate: true
) else {
    FileHandle.standardError.write(Data("unable to create print operation\n".utf8))
    exit(66)
}

operation.showsPrintPanel = requestedPrinterName == nil || requestedPrinterName?.isEmpty == true
operation.showsProgressPanel = operation.showsPrintPanel
application.activate(ignoringOtherApps: true)
let completed = operation.run()
exit(completed ? 0 : 2)

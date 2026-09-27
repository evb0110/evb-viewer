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
let printInfo = NSPrintInfo.shared.copy() as! NSPrintInfo
guard let operation = document.printOperation(
    for: printInfo,
    scalingMode: .pageScaleToFit,
    autoRotate: true
) else {
    FileHandle.standardError.write(Data("unable to create print operation\n".utf8))
    exit(66)
}

operation.showsPrintPanel = true
operation.showsProgressPanel = true
application.activate(ignoringOtherApps: true)
let completed = operation.run()
exit(completed ? 0 : 2)

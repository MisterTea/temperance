import SwiftUI

/// The same mark and colors as the dashboard, with a readable dark appearance.
struct BrandHeader: View {
    var body: some View {
        HStack(spacing: 12) {
            Image("BrandMark").renderingMode(.template).resizable()
                .frame(width: 42, height: 42).accessibilityHidden(true)
            Text("Temperance").font(.largeTitle).bold()
        }.foregroundStyle(Color.accentColor)
    }
}

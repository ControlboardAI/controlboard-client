import AppKit

// The ControlBoard tomoe mark as a menu-bar TEMPLATE image: the rounded-square
// silhouette with the three commas + centre dot punched out to transparency
// (generated from client/public/favicon.svg). isTemplate lets macOS recolour it
// for light/dark menu bars and selection, like every other status icon.
enum Logo {
    private static let png36 = "iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAACW0lEQVR4nMyYOWhUURSG/4lLXKO4EUGigmi0s7GyCFi4FYqCWk4lgmAhimJvoWAhFjY2Vm4I2iQhkEAgTTZSBlJkJZA9ZCkSEkj+w71D7tzc5N37lsl88DF3ecMcLued895UoMyoQJmxO2I/R4/Ss/ozCfN0kM7SNcQI6An9gWx4TH+7NnKOtUr6i95DtvyHCmzZXNzluPAnfYDsqaWX6B9z0T6h27QepeUObShM7IAk4ZImbygz9HhhYt72+2MG06K/d4S+0D8QwjH925sCqkU8vtA5qNtaxhdpF8I4D0dAlYhHlTWfpjdoP/ypcgUUl+9Q9eqasSan9RQxSKt1SBFtp/+gckJopgMIJO1eJsVUAqvW8w4EkkVzvQBVhaXo7kEgoQF9hqoZ7yKuk3x6T+sQSFS3N3lLP9AD9JW1N6w/a4y1N4iBb0CdOhjhLjYSVxij5/R4lJ5GAnwD+mSMr1t75rNNDgnxDajJGJ+x9uREBvW4GgnxSeoFqKZbYMVxTQ2K88dETjdPx+GBzwnZQQ/Bj3EdSKOeT8Dj0cbnhA7CaH6Iri3d9CVUk2001nvhgW8OSRd/Rm/Sh459KYT3t/m+PF58hQe+hVFu9RH6De5ckZbxEeo0bR7RHnoLHoQUxihe0+co7l9X6CkEkGZAglTxOiTALGSHoG7xneAwXZSBXVmlxqR9alGswrhz7aTOo/TkzYmr9/xFaV4UhU3lwhXQPjoJlVNZMgXVF4tepV11aAkqya7SNqRPK71MT9rBCD6PC3uh2sAJJEN6WR9UEm9J4ueXtCm7f9DWAQAA//+9El5aAAAABklEQVQDAC/AVLoq/4CEAAAAAElFTkSuQmCC"

    static func statusImage() -> NSImage? {
        guard let data = Data(base64Encoded: png36), let img = NSImage(data: data) else { return nil }
        img.size = NSSize(width: 18, height: 18)
        img.isTemplate = true
        return img
    }
}

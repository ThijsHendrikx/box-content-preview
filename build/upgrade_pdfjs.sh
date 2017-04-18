DOC_STATIC_ASSETS_VERSION=$(./build/current_version.sh)
DOC_STATIC_ASSETS_PATH="src/third-party/doc/$DOC_STATIC_ASSETS_VERSION"

if [ ! -d $DOC_STATIC_ASSETS_PATH ]; then
    DOC_LATEST_STATIC_ASSETS=`ls src/third-party/doc | sort -nr | head -1`
    echo "Latest version is $DOC_LATEST_STATIC_ASSETS"
    `cp -R src/third-party/doc/$DOC_LATEST_STATIC_ASSETS $DOC_STATIC_ASSETS_PATH`
    echo "Created build directory for $DOC_STATIC_ASSETS_PATH"
fi

echo "-----------------------------------------------------------------------------------"
echo "Fetching latest pdf.js files from pdfjs-dist repo..."
echo "-----------------------------------------------------------------------------------"
rm -rf ./pdfjs-dist/
git clone https://github.com/mozilla/pdfjs-dist.git

echo "-----------------------------------------------------------------------------------"
echo "Copying relevant files to Preview third-party dir..."
echo "-----------------------------------------------------------------------------------"
cp pdfjs-dist/build/pdf.js src/third-party/doc/$DOC_STATIC_ASSETS_VERSION/
cp pdfjs-dist/build/pdf.worker.js src/third-party/doc/$DOC_STATIC_ASSETS_VERSION/
cp pdfjs-dist/web/pdf_viewer.js src/third-party/doc/$DOC_STATIC_ASSETS_VERSION/
cp pdfjs-dist/web/pdf_viewer.css src/third-party/doc/$DOC_STATIC_ASSETS_VERSION/
cp pdfjs-dist/cmaps/* src/third-party/doc/$DOC_STATIC_ASSETS_VERSION/cmaps/
rm -rf ./pdfjs-dist/

# Fix Chrome console warning issue by not testing for moz-chunked-arraybuffer support in Chrome
echo "-----------------------------------------------------------------------------------"
echo "Tweaking pdf.worker.js for Chrome..."
echo "-----------------------------------------------------------------------------------"
sed -e 's/function supportsMozChunkedClosure/!\(\/Chrome\/\.test\(navigator\.userAgent\)\) \&\& function supportsMozChunkedClosure/' -i '' src/third-party/doc/$DOC_STATIC_ASSETS_VERSION/pdf.worker.js

# Disable font loading API to prevent glitches
echo "-----------------------------------------------------------------------------------"
echo "Disabling font loading API to prevent font glitches..."
echo "-----------------------------------------------------------------------------------"
sed -e 's/FontLoader\.isFontLoadingAPISupported = /FontLoader\.isFontLoadingAPISupported = false; \/\/ /' -i '' src/third-party/doc/$DOC_STATIC_ASSETS_VERSION/pdf.js
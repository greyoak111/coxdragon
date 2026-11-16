package cox.dragon;

public final class UpdateSourcesTest {
    public static void main(String[] args) {
        expect(UpdateSources.feed(UpdateSources.APP), "https://api.github.com/repos/leemwood/coxdragon/releases?per_page=30");
        expect(UpdateSources.feed(UpdateSources.DEVKIT), "https://api.github.com/repos/greyoak111/coxdragon/releases?per_page=30");
        expect(UpdateSources.release(UpdateSources.APP, "v1.2.3") + "coxdragon.apk", "https://github.com/leemwood/coxdragon/releases/download/v1.2.3/coxdragon.apk");
        expect(UpdateSources.release(UpdateSources.DEVKIT, "devkit-1.0"), "https://github.com/greyoak111/coxdragon/releases/download/devkit-1.0/");
        expect(UpdateSources.COMPONENTS, "greyoak111/coxdragon-components");
        System.out.println("UpdateSourcesTest: 5 passed");
    }
    private static void expect(String actual, String expected) { if (!expected.equals(actual)) throw new AssertionError(actual); }
}

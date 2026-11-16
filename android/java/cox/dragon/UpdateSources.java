package cox.dragon;

/** Independent release channels. No authentication credentials belong in an APK. */
final class UpdateSources {
    static final String APP = "leemwood/coxdragon";
    static final String DEVKIT = "greyoak111/coxdragon";
    static final String COMPONENTS = "greyoak111/coxdragon-components";

    static String feed(String repository) {
        return "https://api.github.com/repos/" + repository + "/releases?per_page=30";
    }
    static String release(String repository, String tag) {
        return "https://github.com/" + repository + "/releases/download/" + tag + "/";
    }
}
